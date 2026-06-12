/**
 * claims-table.test.tsx — QA-C (pong1 2026-06-12) claim-centric table.
 *
 * Pins the redesign's honesty contract:
 * - One row per unique test (single-counted), grouped epic → story.
 * - Level chips (L0/L1/L2) are VISIBLE on rows.
 * - The wave-gate VQA fix-forward arc renders inline (W2 ✗ → W3 ✓).
 * - EVERY row — pass or fail — is clickable into the evidence drawer.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/labs'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn() })),
}));

import { ClaimsTable, type ClaimRow } from '../claims-table';
import type { QaReport, VqaTestResult } from '@/types/qa-report';

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
    generatedAt: '2026-06-12T00:00:00Z',
    ...over,
  };
}

describe('ClaimsTable — claim-centric QA surface', () => {
  it('renders one row per unique test with level chips visible', () => {
    render(<ClaimsTable report={makeReport()} onSelect={() => {}} />);
    expect(screen.getByText('AC-1')).toBeInTheDocument();
    expect(screen.getByText('AC-S5-1')).toBeInTheDocument();
    // The operator's #1 complaint: L0/L1/L2 were invisible. Now chips.
    expect(screen.getByText('L1')).toBeInTheDocument();
    expect(screen.getByText('L2')).toBeInTheDocument();
    // Grouped by epic → story.
    expect(screen.getByText('Court story')).toBeInTheDocument();
    expect(screen.getByText('Ball physics')).toBeInTheDocument();
  });

  it('renders the wave-gate fix-forward arc inline (W2 fail → W3 pass)', () => {
    render(<ClaimsTable report={makeReport()} onSelect={() => {}} />);
    // The arc lives in one mono span: "W2 ✗ → W3 ✓".
    const arc = screen.getByTitle(/Gate VQA: fixed-by-story/);
    expect(arc.textContent).toContain('W2 ✗');
    expect(arc.textContent).toContain('W3 ✓');
  });

  it('EVERY row opens the drawer — passing rows included, with the gate claim joined', () => {
    const selected: ClaimRow[] = [];
    render(<ClaimsTable report={makeReport()} onSelect={(row) => selected.push(row)} />);
    fireEvent.click(screen.getByText('AC-S5-1'));
    expect(selected).toHaveLength(1);
    expect(selected[0].test.testId).toBe('VT-2');
    expect(selected[0].test.status).toBe('pass');
    expect(selected[0].claim?.final).toBe('fixed-by-story');
    expect(selected[0].claim?.fixStoryId).toBe('S6');
  });

  it('claims without gate history render an em-dash, never a fabricated verdict', () => {
    render(<ClaimsTable report={makeReport()} onSelect={() => {}} />);
    expect(screen.getByTitle(/No wave-gate VQA history for this claim/)).toBeInTheDocument();
  });
});
