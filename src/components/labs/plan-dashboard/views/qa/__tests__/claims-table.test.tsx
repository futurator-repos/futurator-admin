/**
 * claims-table.test.tsx — QA-C claim-centric table, accordion edition
 * (pacman1 UX pass 2026-06-12).
 *
 * Pins the redesign's honesty contract:
 * - One row per unique test (single-counted), grouped epic → story.
 * - Level chips (L0/L1/L2) are VISIBLE on rows.
 * - The wave-gate fix-forward arc renders inline (W2 ✗ → W3 ✓).
 * - Rows expand IN PLACE: the expander carries the judge rationale, the
 *   level meaning, the gate history, and a clickable full-size screenshot.
 * - Failure rows expose Send back / Accept actions inline.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/labs'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn() })),
}));

import { ClaimsTable } from '../claims-table';
import type { QaReport, VqaTestResult } from '@/types/qa-report';

function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function vqaResult(over: Partial<VqaTestResult>): VqaTestResult {
  return {
    testId: 'VT-1',
    storyId: 'S1',
    epicId: 'E-A',
    storyTitle: 'Court story',
    epicLabel: 'E1',
    criteriaRef: 'AC-1',
    passed: true,
    status: 'pass',
    level: 'L1',
    expected: 'The court renders with two paddles',
    rationale: 'Two paddles visible at both edges of the court',
    screenshotUrl: 'https://shots/vt-1.png',
    ...over,
  };
}

function makeReport(over: Partial<QaReport> = {}): QaReport {
  return {
    planId: 'P-1',
    rigor: 'mvp',
    autoRunQa: true,
    hasBrowserTests: true,
    verdict: 'ready',
    ac: {
      verdict: 'pass',
      total: 1,
      pass: 1,
      fail: 0,
      pending: 0,
      failures: [],
      canManuallyApprove: false,
    },
    vqa: {
      verdict: 'pass',
      total: 2,
      pass: 2,
      fail: 0,
      pending: 0,
      thumbnails: [],
      failures: [],
      results: [
        vqaResult({}),
        vqaResult({
          testId: 'VT-2',
          storyId: 'S5',
          storyTitle: 'Ball physics',
          epicLabel: 'E2',
          epicId: 'E-B',
          criteriaRef: 'AC-S5-1',
          level: 'L2',
          expected: 'Ball bounces off the paddle',
        }),
      ],
      executeStatus: 'done',
    },
    gate: { verdict: 'pass', activeChecks: ['compile'], waveRows: [], tamperCountsByStory: {} },
    gateVqa: {
      verified: 0,
      fixedInGate: 0,
      fixedByStory: 1,
      fixForwarded: 0,
      unverifiable: 0,
      claims: [
        {
          acId: 'AC-S5-1',
          storyId: 'S5',
          epicId: 'E-B',
          acText: 'Ball bounces off the paddle',
          attempts: [
            { waveNumber: 2, result: 'FAIL', observation: 'passes through', jobId: 'g2' },
            { waveNumber: 3, result: 'PASS', jobId: 'g3' },
          ],
          final: 'fixed-by-story',
          fixStoryId: 'S6',
        },
      ],
    },
    perEpic: [],
    qaRuns: [],
    attentionItems: [],
    runHistory: [],
    devPreview: { epicId: 'E-1', status: 'none' },
    generatedAt: '2026-06-12T00:00:00Z',
    ...over,
  };
}

describe('ClaimsTable — claim-centric accordion', () => {
  it('renders one row per unique test with level chips visible, grouped epic → story', () => {
    renderWithQuery(<ClaimsTable report={makeReport()} planId="P-1" />);
    expect(screen.getByText('AC-1')).toBeInTheDocument();
    expect(screen.getByText('AC-S5-1')).toBeInTheDocument();
    expect(screen.getAllByText('L1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('L2').length).toBeGreaterThan(0);
    expect(screen.getByText('Court story')).toBeInTheDocument();
    expect(screen.getByText('Ball physics')).toBeInTheDocument();
  });

  it('renders the wave-gate fix-forward arc inline (W2 fail → W3 pass), joined by (storyId, acId)', () => {
    renderWithQuery(<ClaimsTable report={makeReport()} planId="P-1" />);
    const arc = screen.getByTitle(/Gate verification: fixed-by-story/);
    expect(arc.textContent).toContain('W2 ✗');
    expect(arc.textContent).toContain('W3 ✓');
  });

  it('clicking a row expands it IN PLACE with rationale, level meaning, gate history, screenshot link', () => {
    renderWithQuery(<ClaimsTable report={makeReport()} planId="P-1" />);
    // Nothing expanded initially.
    expect(screen.queryByText(/What the judge saw/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('AC-S5-1'));
    // Judge rationale section + level explainer + gate history rendered inline.
    expect(screen.getByText(/How it was checked/i)).toBeInTheDocument();
    // The level explainer (the footer legend also mentions "interaction
    // flow", so assert on the full explainer sentence).
    expect(screen.getByText(/scripted clicks\/keys are performed/i)).toBeInTheDocument();
    expect(screen.getByText(/History at the wave gates/i)).toBeInTheDocument();
    expect(screen.getByText('FAIL')).toBeInTheDocument();
    // Screenshot links out to the full-size capture.
    const shotLink = screen.getByTitle(/Open the full-size screenshot/i);
    expect(shotLink).toHaveAttribute('href', 'https://shots/vt-1.png');
    expect(shotLink).toHaveAttribute('target', '_blank');

    // Clicking again collapses.
    fireEvent.click(screen.getByText('AC-S5-1'));
    expect(screen.queryByText(/History at the wave gates/i)).not.toBeInTheDocument();
  });

  it('failing rows expose Send back + Accept actions inline; passing rows do not', () => {
    const report = makeReport();
    report.vqa.results![1] = vqaResult({
      testId: 'VT-2',
      storyId: 'S5',
      storyTitle: 'Ball physics',
      epicLabel: 'E2',
      epicId: 'E-B',
      criteriaRef: 'AC-S5-1',
      passed: false,
      status: 'fail',
      failureClass: 'render',
    });
    renderWithQuery(<ClaimsTable report={report} planId="P-1" />);

    fireEvent.click(screen.getByText('AC-S5-1'));
    expect(screen.getByText('Send back to dev')).toBeInTheDocument();
    expect(screen.getByText(/Accept \(known limitation\)/)).toBeInTheDocument();
    // The stale-AC honesty banner: this claim passed at the gate.
    expect(screen.getByText(/Passed at the wave gate/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText('AC-S5-1'));

    fireEvent.click(screen.getByText('AC-1'));
    expect(screen.queryByText('Send back to dev')).not.toBeInTheDocument();
  });

  it('claims without gate history render an em-dash, never a fabricated verdict', () => {
    renderWithQuery(<ClaimsTable report={makeReport()} planId="P-1" />);
    expect(screen.getByTitle(/No wave-gate verification history/)).toBeInTheDocument();
  });
});
